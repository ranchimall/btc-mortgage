(function (EXPORTS) {
    const btcMortgage = EXPORTS;

    //USERS: B: Borrower, L: Lender, C: Collateral provider, T: Trusted banker (us)

    var BankerPubKey = "0257a9c47462fe89b159daa204ddb964c9b098a020641cc8090a9cad4f6dd2172a";

    const CURRENCY = "USD";

    const PERIOD_REGEX = /^\d{1,5}(Y|M|D)$/,
        TXID_REGEX = /^[0-9a-f]{64}$/i,
        VALUE_REGEX = /^\d+(.\d{1,8})?$/;

    const POLICIES = {}

    const toFixedDecimal = value => parseFloat((value).toFixed(8));

    function encodePeriod(str) {

        if (typeof str != 'string')
            throw "passed value must be string";

        if (PERIOD_REGEX.test(str)) //already in format
            return str;

        let P = '', n = 0;
        str.toLowerCase().replace(/,/g, '').split(" ").forEach(s => {
            if (!isNaN(s))
                n = parseInt(s);
            else switch (s) {
                case "year(s)": case "year": case "years": P += (n + 'Y'); n = 0; break;
                case "month(s)": case "month": case "months": P += (n + 'M'); n = 0; break;
                case "day(s)": case "day": case "days": P += (n + 'D'); n = 0; break;
            }
        });

        if (!PERIOD_REGEX.test(P)) {//not in format: something wrong
            console.error(`encodePeriod('${str}') failed`, P)
            throw "Invalid period";
        }

        return P;
    }

    function decodePeriod(str) {
        if (typeof str != 'string')
            throw "passed value must be string";

        else if (!PERIOD_REGEX.test(str)) //not in format
            throw "Invalid period";

        let n = parseInt(str);
        let v = str[str.length - 1];

        switch (v) {
            case 'Y': return n + (n == 1 ? "year" : "years");
            case 'M': return n + (n == 1 ? "month" : "months");
            case "D": return n + (n == 1 ? "day" : "days");
        }

    }

    const dateFormat = (date = null) => {
        let d = (date ? new Date(date) : new Date()).toDateString();
        return [d.substring(8, 10), d.substring(4, 7), d.substring(11, 15)].join(" ");
    }
    const yearDiff = (d1 = null, d2 = null) => {
        d1 = d1 ? new Date(d1) : new Date();
        d2 = d2 ? new Date(d2) : new Date();
        let y = d1.getYear() - d2.getYear(),
            m = d1.getMonth() - d2.getMonth(),
            d = d1.getDate() - d2.getDate()
        return y + m / 12 + d / 365;
    }

    const dateAdder = function (start_date, duration) {
        let date = new Date(start_date);
        let y = parseInt(duration.match(/\d+Y/)),
            m = parseInt(duration.match(/\d+M/)),
            d = parseInt(duration.match(/\d+D/));
        if (!isNaN(y))
            date.setFullYear(date.getFullYear() + y);
        if (!isNaN(m))
            date.setMonth(date.getMonth() + m);
        if (!isNaN(d))
            date.setDate(date.getDate() + d);
        return date;
    }

    function calcAllowedLoan(collateralQuantity, security_percent) {
        return collateralQuantity * security_percent;
    }

    function calcRequiredCollateral(loanEquivalent, security_percent) {
        let inverse_security_percent = 1 / security_percent;
        return loanEquivalent * inverse_security_percent;
    }

    function findLocker(coborrower_pubKey, lender_pubKey) {
        return btcOperator.multiSigAddress([coborrower_pubKey, lender_pubKey, BankerPubKey], 2);
    }

    function extractPubKeyFromSign(sign) {
        return sign.split('.')[0];
    }

    btcMortgage.util = {
        toFixedDecimal,
        encodePeriod, decodePeriod,
        calcAllowedLoan, calcRequiredCollateral,
        findLocker, extractPubKeyFromSign
    }

    //get BTC rates
    const getRate = btcMortgage.getRate = {};

    getRate["BTC"] = function () {
        return new Promise((resolve, reject) => {
            fetch('https://api.coinlore.net/api/ticker/?id=90').then(response => {
                if (response.ok) {
                    response.json()
                        .then(result => resolve(result[0].price_usd))
                        .catch(error => reject(error));
                } else
                    reject(response.status);
            }).catch(error => reject(error));
        });
    }

    //Loan details on FLO blockchain
    const LOAN_DETAILS_IDENTIFIER = "BTC Mortage: Loan details";

    function stringifyLoanOpenData(
        borrower, loan_amount, policy_id,
        coborrower, collateral_value, collateral_lock_id,
        lender, loan_transfer_id,
        borrower_sign, coborrower_sign, lender_sign
    ) {
        return [
            LOAN_DETAILS_IDENTIFIER,
            "Borrower:" + floCrypto.toFloID(borrower),
            "Amount:" + loan_amount,
            "Policy:" + policy_id,
            "CoBorrower:" + floCrypto.toFloID(coborrower),
            "CollateralValue:" + collateral_value + "BTC",
            "CollateralLock:" + collateral_lock_id,
            "Lender:" + floCrypto.toFloID(lender),
            "TokenTransfer:" + loan_transfer_id,
            "Signature-B:" + borrower_sign,
            "Signature-C:" + coborrower_sign,
            "Signature-L:" + lender_sign
        ].join('|');
        /*MAYDO: Maybe make it a worded sentence?
            BTC Mortage: 
            L#${lender_floid} is lending ${loan_amount}USD (ref#${loan_transfer_id}) to B#${borrower_floid}
            inaccoradance with policy#${policy_id} 
            as mortage on collateral#${collateral_id} (${btc_amount}BTC) provided by C#${coborrower_floid}.
            Signed by B'${borrower_sign} , C'{coborrower_sign} and L'${lender_sign}    
        */
    }

    function parseLoanOpenData(str, tx_time) {
        let splits = str.split('|');
        if (splits[0] !== LOAN_DETAILS_IDENTIFIER)
            throw "Invalid Loan blockchain data";
        var details = { open_time: tx_time };
        splits.forEach(s => {
            let d = s.split(':');
            switch (d[0]) {
                case "Borrower": details.borrower = d[1]; break;
                case "Amount": details.loan_amount = parseFloat(d[1]); break;
                case "Policy": details.policy_id = d[1]; break;
                case "CoBorrower": details.coborrower = d[1]; break;
                case "CollateralValue": details.collateral_value = parseFloat(d[1]); break;
                case "CollateralLock": details.collateral_lock_id = d[1]; break;
                case "Lender": details.lender = d[1]; break;
                case "TokenTransfer": details.loan_transfer_id = d[1]; break;
                case "Signature-B": details.borrower_sign = d[1]; break;
                case "Signature-C": details.coborrower_sign = d[1]; break;
                case "Signature-L": details.lender_sign = d[1]; break;
            }
        });
        return details;
    }

})(window.btcMortgage = {})